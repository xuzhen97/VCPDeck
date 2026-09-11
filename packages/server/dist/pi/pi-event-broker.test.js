"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const rxjs_1 = require("rxjs");
const pi_event_broker_js_1 = require("./pi-event-broker.js");
const pi_request_broker_js_1 = require("./pi-request-broker.js");
function runServiceMock() {
    return {
        waitForInput: vitest_1.vi.fn(async () => { }),
        resume: vitest_1.vi.fn(async () => { }),
        cancelSettlement: vitest_1.vi.fn(),
        scheduleSettlement: vitest_1.vi.fn(async (_jobId, onSettle) => {
            // 测试直接触发 onSettle（不等待 30s）
            void onSettle;
        }),
        finishRun: vitest_1.vi.fn(async () => true),
        withReconciledClient: vitest_1.vi.fn(async (_clientId, operation) => operation({ clientId: "c1", socketId: "socket-1" })),
        reconcileState: vitest_1.vi.fn(async () => { }),
    };
}
function makeEvent(overrides = {}) {
    return {
        clientId: "c1",
        sessionId: "s1",
        jobId: "j1",
        runId: "j1",
        event: { type: "agent_end", sessionId: "s1" },
        ...overrides,
    };
}
function makeBroker(overrides = {}) {
    const requests = new pi_request_broker_js_1.PiRequestBroker();
    requests.bindEmitter(() => { });
    const runs = overrides.runs ?? runServiceMock();
    const broker = new pi_event_broker_js_1.PiEventBroker(requests, runs);
    return { broker, requests, runs };
}
async function collectStream(broker, clientId, sessionId, count) {
    const events = await (0, rxjs_1.firstValueFrom)(broker
        .stream(clientId, sessionId)
        .pipe((0, rxjs_1.take)(count), (0, rxjs_1.toArray)(), (0, rxjs_1.timeout)(2000)));
    return events.map((e) => String(e.data));
}
(0, vitest_1.describe)("PiEventBroker", () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)("事件只扇出给同 client/session 订阅者", async () => {
        const { broker } = makeBroker();
        const streamPromise = collectStream(broker, "c1", "s1", 1);
        await broker.publish(makeEvent({
            clientId: "c1",
            sessionId: "s1",
            event: { type: "agent_end", sessionId: "s1" },
        }));
        const events = await streamPromise;
        (0, vitest_1.expect)(events).toHaveLength(1);
        let parsed = null;
        try {
            parsed = JSON.parse(events[0] ?? "null");
        }
        catch {
            // 解析失败视为断言失败
        }
        (0, vitest_1.expect)(parsed).toMatchObject({ clientId: "c1", sessionId: "s1" });
    });
    (0, vitest_1.it)("其他 session 的订阅者收不到事件", async () => {
        const { broker } = makeBroker();
        const otherPromise = collectStream(broker, "c1", "s2", 1);
        await broker.publish(makeEvent({ sessionId: "s1" }));
        // s2 无事件：心跳 30s 太慢，用短超时验证无数据
        await (0, vitest_1.expect)((0, rxjs_1.firstValueFrom)(broker.stream("c1", "s2").pipe((0, rxjs_1.take)(1), (0, rxjs_1.timeout)(300)))).rejects.toThrow();
        await otherPromise.catch(() => { });
    });
    (0, vitest_1.it)("interactive request 使用 jobId + runId 进入 waiting", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        await broker.publish(makeEvent({
            event: {
                type: "extension_request",
                sessionId: "s1",
                ui: { requestId: "u1", extensionId: "e", kind: "confirm" },
            },
        }));
        (0, vitest_1.expect)(runs.waitForInput).toHaveBeenCalledWith("j1", "j1");
    });
    (0, vitest_1.it)("notify extension_request 不触发 waitForInput", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        await broker.publish(makeEvent({
            event: {
                type: "extension_request",
                sessionId: "s1",
                ui: {
                    requestId: "u-notify",
                    extensionId: "e",
                    kind: "notify",
                    message: "info: Agent finished its current task.",
                },
            },
        }));
        (0, vitest_1.expect)(runs.waitForInput).not.toHaveBeenCalled();
        (0, vitest_1.expect)(runs.cancelSettlement).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("agent_start 取消 settlement grace", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        await broker.publish(makeEvent({ event: { type: "agent_start", sessionId: "s1" } }));
        (0, vitest_1.expect)(runs.cancelSettlement).toHaveBeenCalledWith("j1", "j1");
    });
    (0, vitest_1.it)("prompt_done/agent_settled 触发 settlement 检查", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        await broker.publish(makeEvent({ event: { type: "prompt_done", sessionId: "s1" } }));
        const scheduleMock = runs.scheduleSettlement;
        (0, vitest_1.expect)(scheduleMock).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(scheduleMock.mock.calls[0]?.slice(0, 2)).toEqual(["j1", "j1"]);
        await broker.publish(makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }));
        (0, vitest_1.expect)(scheduleMock).toHaveBeenCalledTimes(2);
    });
    function makeSettleBroker(state) {
        let onSettle = null;
        const runs = {
            waitForInput: vitest_1.vi.fn(async () => { }),
            resume: vitest_1.vi.fn(async () => { }),
            cancelSettlement: vitest_1.vi.fn(),
            scheduleSettlement: vitest_1.vi.fn(async (_jobId, _runId, cb) => {
                onSettle = cb;
            }),
            finishRun: vitest_1.vi.fn(async () => true),
            withReconciledClient: vitest_1.vi.fn(async (_clientId, operation) => operation({ clientId: "c1", socketId: "socket-1" })),
            reconcileState: vitest_1.vi.fn(async () => { }),
        };
        const requests = new pi_request_broker_js_1.PiRequestBroker();
        requests.bindEmitter((_socketId, request) => {
            queueMicrotask(() => {
                requests.resolve("socket-1", {
                    requestId: request.requestId,
                    ok: true,
                    data: state,
                });
            });
        });
        const broker = new pi_event_broker_js_1.PiEventBroker(requests, runs);
        return { broker, runs, getOnSettle: () => onSettle };
    }
    (0, vitest_1.it)("settlement 只把当前 run 收敛为 idle", async () => {
        const { broker, runs, getOnSettle } = makeSettleBroker({
            status: "idle",
            streaming: false,
            prompting: false,
            compacting: false,
            thinkingLevel: "off",
            queuedMessages: { steering: [], followUp: [] },
        });
        await broker.publish(makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }));
        (0, vitest_1.expect)(getOnSettle()).not.toBeNull();
        await getOnSettle()();
        (0, vitest_1.expect)(runs.scheduleSettlement).toHaveBeenCalledWith("j1", "j1", vitest_1.expect.any(Function));
        (0, vitest_1.expect)(runs.finishRun).toHaveBeenCalledWith("j1", "j1");
    });
    (0, vitest_1.it)("settlement 回调在 queue 非空时不 settle", async () => {
        const { broker, runs, getOnSettle } = makeSettleBroker({
            status: "idle",
            streaming: false,
            prompting: false,
            compacting: false,
            thinkingLevel: "off",
            queuedMessages: { steering: ["s1"], followUp: [] },
        });
        await broker.publish(makeEvent({ event: { type: "prompt_done", sessionId: "s1" } }));
        await getOnSettle()();
        (0, vitest_1.expect)(runs.finishRun).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("settlement 回调在非 idle 状态时不 settle", async () => {
        const { broker, runs, getOnSettle } = makeSettleBroker({
            status: "running",
            streaming: true,
            prompting: true,
            compacting: false,
            thinkingLevel: "off",
            queuedMessages: { steering: [], followUp: [] },
        });
        await broker.publish(makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }));
        await getOnSettle()();
        (0, vitest_1.expect)(runs.finishRun).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("仍有排队 Extension 时不恢复 running", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        await broker.publish(makeEvent({
            event: {
                type: "extension_resolved",
                sessionId: "s1",
                requestId: "ui-1",
                reason: "answered",
                hasPending: true,
            },
        }));
        (0, vitest_1.expect)(runs.resume).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("最后一个 Extension 解决后恢复 running", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        await broker.publish(makeEvent({
            event: {
                type: "extension_resolved",
                sessionId: "s1",
                requestId: "ui-2",
                reason: "timeout",
                hasPending: false,
            },
        }));
        (0, vitest_1.expect)(runs.resume).toHaveBeenCalledWith("j1", "j1");
    });
    (0, vitest_1.it)("prompt_error 只结束当前 run，错误正文仅保留在 SSE", async () => {
        const runs = runServiceMock();
        const { broker } = makeBroker({ runs });
        const streamPromise = collectStream(broker, "c1", "s1", 1);
        await broker.publish(makeEvent({
            event: {
                type: "prompt_error",
                sessionId: "s1",
                code: "PI_WORKER_EXITED",
                message: "SENTINEL_PROMPT_ERROR",
            },
        }));
        (0, vitest_1.expect)(runs.cancelSettlement).toHaveBeenCalledWith("j1", "j1");
        (0, vitest_1.expect)(runs.finishRun).toHaveBeenCalledWith("j1", "j1");
        (0, vitest_1.expect)((await streamPromise)[0]).toContain("SENTINEL_PROMPT_ERROR");
    });
});
