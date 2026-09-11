"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const agent_session_js_1 = require("./agent-session.js");
class FakeInner {
    sessionId = "s1";
    sessionFile = "/tmp/sessions/s1.jsonl";
    isStreaming = false;
    isCompacting = false;
    thinkingLevel = "off";
    model = {
        provider: "p",
        id: "m1",
    };
    modelRuntime = {
        getAvailable: vitest_1.vi.fn(async () => [{ provider: "p", id: "m1" }]),
        getModel: vitest_1.vi.fn((_provider, _modelId) => ({
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
        createBranchedSession: vitest_1.vi.fn(() => undefined),
        newSession: vitest_1.vi.fn(),
    };
    settingsManager = { getEnabledModels: () => undefined };
    agent = { state: { thinkingLevel: "off" } };
    promptTemplates = [];
    resourceLoader = { getSkills: () => ({ skills: [] }) };
    extensionRunner = {
        getRegisteredCommands: () => [],
        setUIContext: vitest_1.vi.fn((ctx) => {
            this.uiContext = ctx;
        }),
        emit: vitest_1.vi.fn(async () => { }),
    };
    uiContext = null;
    dispose = vitest_1.vi.fn();
    listener = null;
    promptResolve = null;
    promptReject = null;
    promptCalls = 0;
    prompt = vitest_1.vi.fn(() => new Promise((resolve, reject) => {
        this.promptCalls++;
        this.promptResolve = resolve;
        this.promptReject = reject;
    }));
    abort = vitest_1.vi.fn(async () => { });
    steer = vitest_1.vi.fn(async () => { });
    followUp = vitest_1.vi.fn(async () => { });
    compact = vitest_1.vi.fn(async () => ({}));
    abortCompaction = vitest_1.vi.fn();
    setThinkingLevel = vitest_1.vi.fn();
    setModel = vitest_1.vi.fn(async () => { });
    setSessionName = vitest_1.vi.fn();
    navigateTree = vitest_1.vi.fn(async () => ({ cancelled: false }));
    getSessionStats = vitest_1.vi.fn(() => ({ totalMessages: 2 }));
    getSteeringMessages = () => [];
    getFollowUpMessages = () => [];
    getContextUsage = () => undefined;
    pendingMessageCount = 0;
    subscribe = (listener) => {
        this.listener = listener;
        return () => {
            this.listener = null;
        };
    };
    emit(event) {
        this.listener?.(event);
    }
    resolvePrompt() {
        this.promptResolve?.();
    }
    rejectPrompt(err) {
        this.promptReject?.(err);
    }
}
function makeWrapper() {
    const inner = new FakeInner();
    const wrapper = new agent_session_js_1.PiAgentSessionWrapperImpl(inner);
    wrapper.start();
    return { inner, wrapper };
}
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
    vitest_1.vi.restoreAllMocks();
});
(0, vitest_1.describe)("PiAgentSessionWrapperImpl", () => {
    (0, vitest_1.it)("prompt fire-and-forget：resolve 后发 prompt_done", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((e) => events.push(e.type));
        await wrapper.send("agent.prompt", { prompt: "hi" });
        (0, vitest_1.expect)(inner.prompt).toHaveBeenCalledWith("hi", vitest_1.expect.objectContaining({ source: "rpc" }));
        inner.resolvePrompt();
        await Promise.resolve();
        (0, vitest_1.expect)(events).toContain("prompt_done");
        (0, vitest_1.expect)(wrapper.isRunning()).toBe(false);
    });
    (0, vitest_1.it)("prompt 失败发 prompt_error", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((e) => events.push(e.type));
        await wrapper.send("agent.prompt", { prompt: "boom" });
        inner.rejectPrompt(new Error("provider down"));
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(events).toContain("prompt_error"));
    });
    (0, vitest_1.it)("agent_end 只是阶段事件，不销毁 wrapper", () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((e) => events.push(e.type));
        inner.emit({ type: "agent_end" });
        (0, vitest_1.expect)(events).toContain("agent_end");
        (0, vitest_1.expect)(wrapper.isAlive()).toBe(true);
    });
    (0, vitest_1.it)("Extension confirm：事件转发 + Owner 响应解决", async () => {
        const { inner, wrapper } = makeWrapper();
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(inner.uiContext).not.toBeNull());
        const events = [];
        wrapper.onEvent((e) => events.push(e));
        const ui = inner.uiContext;
        const promise = ui.confirm("Trust?", "Load extensions?");
        await Promise.resolve();
        const req = events.find((e) => typeof e === "object" &&
            e !== null &&
            e.type === "extension_request");
        (0, vitest_1.expect)(req?.ui?.kind).toBe("confirm");
        await wrapper.send("extension.respond", {
            requestId: req?.ui?.requestId,
            confirmed: true,
        });
        await (0, vitest_1.expect)(promise).resolves.toBe(true);
    });
    (0, vitest_1.it)("Extension dialog 缺省 30 分钟 timeout 写入事件", async () => {
        const { inner, wrapper } = makeWrapper();
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(inner.uiContext).not.toBeNull());
        const events = [];
        wrapper.onEvent((e) => events.push(e));
        const ui = inner.uiContext;
        void ui.select("Pick", ["a", "b"]);
        await Promise.resolve();
        const req = events.find((e) => typeof e === "object" &&
            e !== null &&
            e.type === "extension_request");
        (0, vitest_1.expect)(req?.ui?.kind).toBe("select");
        (0, vitest_1.expect)(req?.ui?.timeoutMs).toBe(30 * 60 * 1000);
    });
    (0, vitest_1.it)("custom() 返回 undefined 并发 warning notify", async () => {
        const { inner, wrapper } = makeWrapper();
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(inner.uiContext).not.toBeNull());
        const events = [];
        wrapper.onEvent((e) => events.push(e));
        const ui = inner.uiContext;
        await (0, vitest_1.expect)(ui.custom()).resolves.toBeUndefined();
        const req = events.find((e) => typeof e === "object" &&
            e !== null &&
            e.type === "extension_request");
        (0, vitest_1.expect)(req?.ui?.kind).toBe("notify");
    });
    (0, vitest_1.it)("agent.state 暴露当前活动 Extension 摘要", () => {
        const { inner, wrapper } = makeWrapper();
        void inner.uiContext.confirm("确认", "继续吗？");
        (0, vitest_1.expect)(wrapper.getState().pendingExtension).toMatchObject({
            kind: "confirm",
            title: "确认",
            message: "继续吗？",
        });
    });
    (0, vitest_1.it)("回答后发出 answered 并清空状态", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        const promise = inner.uiContext.input("输入", "内容");
        const requestId = wrapper.getState().pendingExtension.requestId;
        await wrapper.send("extension.respond", { requestId, value: "answer" });
        await (0, vitest_1.expect)(promise).resolves.toBe("answer");
        (0, vitest_1.expect)(events).toContainEqual(vitest_1.expect.objectContaining({
            type: "extension_resolved",
            requestId,
            reason: "answered",
            hasPending: false,
        }));
        (0, vitest_1.expect)(wrapper.getState().pendingExtension).toBeUndefined();
    });
    (0, vitest_1.it)("超时发出 timeout", async () => {
        vitest_1.vi.useFakeTimers();
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        const promise = inner.uiContext.input("输入", "内容", {
            timeout: 25,
        });
        await vitest_1.vi.advanceTimersByTimeAsync(25);
        await (0, vitest_1.expect)(promise).resolves.toBeUndefined();
        (0, vitest_1.expect)(events).toContainEqual(vitest_1.expect.objectContaining({
            type: "extension_resolved",
            reason: "timeout",
            hasPending: false,
        }));
    });
    (0, vitest_1.it)("并发请求串行展示，解决一个后仍保持 pending", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        const first = inner.uiContext.confirm("第一项", "A");
        const second = inner.uiContext.input("第二项", "B");
        const firstId = wrapper.getState().pendingExtension.requestId;
        await wrapper.send("extension.respond", {
            requestId: firstId,
            confirmed: true,
        });
        await (0, vitest_1.expect)(first).resolves.toBe(true);
        (0, vitest_1.expect)(events).toContainEqual(vitest_1.expect.objectContaining({
            type: "extension_resolved",
            requestId: firstId,
            hasPending: true,
        }));
        (0, vitest_1.expect)(wrapper.getState().pendingExtension).toMatchObject({
            title: "第二项",
        });
        (0, vitest_1.expect)(second).toBeInstanceOf(Promise);
    });
    (0, vitest_1.it)("abort 只关闭已展示请求并清除排队请求", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        void inner.uiContext.confirm("第一项", "A");
        void inner.uiContext.input("第二项", "B");
        const displayedId = wrapper.getState().pendingExtension.requestId;
        await wrapper.send("agent.abort");
        (0, vitest_1.expect)(inner.abort).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(events.filter((event) => event.type === "extension_resolved")).toEqual([
            vitest_1.expect.objectContaining({
                requestId: displayedId,
                reason: "cancelled",
                hasPending: false,
            }),
        ]);
        (0, vitest_1.expect)(wrapper.getState().pendingExtension).toBeUndefined();
        (0, vitest_1.expect)(wrapper.getState().status).toBe("idle");
    });
    (0, vitest_1.it)("abort 等待 streaming 停止，5 秒后返回 PI_REQUEST_TIMEOUT", async () => {
        vitest_1.vi.useFakeTimers();
        const { inner, wrapper } = makeWrapper();
        inner.isStreaming = true;
        const result = (0, vitest_1.expect)(wrapper.send("agent.abort")).rejects.toMatchObject({
            code: "PI_REQUEST_TIMEOUT",
        });
        await vitest_1.vi.advanceTimersByTimeAsync(5_000);
        await result;
    });
    (0, vitest_1.it)("abort 等待期间 streaming 收敛则成功", async () => {
        vitest_1.vi.useFakeTimers();
        const { inner, wrapper } = makeWrapper();
        inner.isStreaming = true;
        const result = wrapper.send("agent.abort");
        await vitest_1.vi.advanceTimersByTimeAsync(4_975);
        inner.isStreaming = false;
        await vitest_1.vi.advanceTimersByTimeAsync(25);
        await (0, vitest_1.expect)(result).resolves.toBeNull();
    });
    (0, vitest_1.it)("abort 首次失败仍取消 pending UI，第二次会重试底层 abort", async () => {
        const { inner, wrapper } = makeWrapper();
        const trust = inner.uiContext.confirm("Project Trust", "信任？");
        inner.abort.mockRejectedValueOnce(new Error("abort failed"));
        await (0, vitest_1.expect)(wrapper.send("agent.abort")).rejects.toThrow("abort failed");
        await (0, vitest_1.expect)(trust).resolves.toBe(false);
        (0, vitest_1.expect)(wrapper.getState().pendingExtension).toBeUndefined();
        await (0, vitest_1.expect)(wrapper.send("agent.abort")).resolves.toBeNull();
        (0, vitest_1.expect)(inner.abort).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)("destroy 只为活动请求发一次 cancelled，排队请求静默解决", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        const active = inner.uiContext.confirm("第一项", "A");
        const queued = inner.uiContext.input("第二项", "B");
        const activeId = wrapper.getState().pendingExtension.requestId;
        wrapper.destroy();
        await (0, vitest_1.expect)(active).resolves.toBe(false);
        await (0, vitest_1.expect)(queued).resolves.toBeUndefined();
        (0, vitest_1.expect)(events.filter((event) => event.type === "extension_resolved")).toEqual([
            vitest_1.expect.objectContaining({
                requestId: activeId,
                reason: "cancelled",
                hasPending: false,
            }),
        ]);
        (0, vitest_1.expect)(events.filter((event) => event.type === "extension_request")).toHaveLength(1);
    });
    (0, vitest_1.it)("answered 后重复响应不重复发 extension_resolved", async () => {
        const { inner, wrapper } = makeWrapper();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        const answer = inner.uiContext.input("输入", "内容");
        const requestId = wrapper.getState().pendingExtension.requestId;
        await wrapper.send("extension.respond", { requestId, value: "first" });
        await wrapper.send("extension.respond", { requestId, value: "second" });
        await (0, vitest_1.expect)(answer).resolves.toBe("first");
        (0, vitest_1.expect)(events.filter((event) => event.type === "extension_resolved" && event.requestId === requestId)).toHaveLength(1);
    });
    (0, vitest_1.it)("model.set 不在交集返回 PI_MODEL_NOT_FOUND", async () => {
        const { wrapper } = makeWrapper();
        const result = await wrapper.send("model.set", {
            provider: "x",
            modelId: "nope",
        });
        (0, vitest_1.expect)(result).toMatchObject({
            ok: false,
            error: { code: "PI_MODEL_NOT_FOUND" },
        });
    });
    (0, vitest_1.it)("agent.state 返回当前 thinking level", () => {
        const { inner, wrapper } = makeWrapper();
        inner.thinkingLevel = "high";
        (0, vitest_1.expect)(wrapper.getState().thinkingLevel).toBe("high");
    });
    (0, vitest_1.it)("thinking.set 校验原生 level 后调用 SDK", async () => {
        const { inner, wrapper } = makeWrapper();
        await wrapper.send("thinking.set", { level: "high" });
        (0, vitest_1.expect)(inner.setThinkingLevel).toHaveBeenCalledWith("high");
        const result = await wrapper.send("thinking.set", { level: "auto" });
        (0, vitest_1.expect)(result).toMatchObject({
            ok: false,
            error: { code: "PI_PROTOCOL_INVALID" },
        });
        (0, vitest_1.expect)(inner.setThinkingLevel).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("get_state 在等待 Extension input 时映射 waiting_for_extension_input", async () => {
        const { inner, wrapper } = makeWrapper();
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(inner.uiContext).not.toBeNull());
        const ui = inner.uiContext;
        void ui.input("Name?");
        await Promise.resolve();
        const state = wrapper.getState();
        (0, vitest_1.expect)(state.status).toBe("waiting_for_extension_input");
        (0, vitest_1.expect)(state.waitingForExtensionInput).toBe(true);
    });
    (0, vitest_1.it)("compact 调用 inner.compact", async () => {
        const { inner, wrapper } = makeWrapper();
        await wrapper.send("agent.compact", { customInstructions: "summarize" });
        (0, vitest_1.expect)(inner.compact).toHaveBeenCalledWith("summarize");
    });
    (0, vitest_1.it)("ensureProjectTrust 复用 confirm 且只执行一次 resolver", async () => {
        const { inner, wrapper } = makeWrapper();
        const resolver = vitest_1.vi.fn(async (ask) => ask("信任？"));
        wrapper.setProjectTrustResolver(resolver);
        const pending = wrapper.ensureProjectTrust();
        const requestId = wrapper.getState().pendingExtension.requestId;
        await wrapper.send("extension.respond", { requestId, confirmed: true });
        await (0, vitest_1.expect)(pending).resolves.toBe(true);
        await (0, vitest_1.expect)(wrapper.ensureProjectTrust()).resolves.toBe(true);
        (0, vitest_1.expect)(resolver).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(inner.dispose).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("ensureProjectTrust 返回 false 时不要求重建", async () => {
        const { wrapper } = makeWrapper();
        const resolver = vitest_1.vi.fn(async () => false);
        wrapper.setProjectTrustResolver(resolver);
        await (0, vitest_1.expect)(wrapper.ensureProjectTrust()).resolves.toBe(false);
        await (0, vitest_1.expect)(wrapper.ensureProjectTrust()).resolves.toBe(false);
        (0, vitest_1.expect)(resolver).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("shutdown 先发 session_shutdown 再 dispose", async () => {
        const { inner, wrapper } = makeWrapper();
        await wrapper.shutdown();
        (0, vitest_1.expect)(inner.extensionRunner.emit).toHaveBeenCalledWith({
            type: "session_shutdown",
            reason: "quit",
        });
        (0, vitest_1.expect)(inner.dispose).toHaveBeenCalled();
        (0, vitest_1.expect)(wrapper.isAlive()).toBe(false);
    });
    (0, vitest_1.it)("空闲 10 分钟优雅关闭", async () => {
        vitest_1.vi.useFakeTimers();
        const { inner, wrapper } = makeWrapper();
        vitest_1.vi.advanceTimersByTime(10 * 60 * 1000 + 100);
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(wrapper.isAlive()).toBe(false));
        (0, vitest_1.expect)(inner.dispose).toHaveBeenCalled();
    });
});
