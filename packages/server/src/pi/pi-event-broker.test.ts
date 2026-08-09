import { afterEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, toArray, take, timeout } from "rxjs";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import type { PiRunService } from "./pi-run.service.js";
import type { PiEvent } from "@vcpdeck/shared";

function runServiceMock() {
	return {
		waitForInput: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		cancelSettlement: vi.fn(),
		scheduleSettlement: vi.fn(
			async (_jobId: string, onSettle: () => Promise<void>) => {
				// 测试直接触发 onSettle（不等待 30s）
				void onSettle;
			},
		),
		finishRun: vi.fn(async () => true),
		withReconciledClient: vi.fn(async (_clientId: string, operation: (lease: { clientId: string; socketId: string }) => Promise<unknown>) =>
			operation({ clientId: "c1", socketId: "socket-1" })),
		reconcileState: vi.fn(async () => {}),
	} as unknown as PiRunService;
}

function makeEvent(overrides: Partial<PiEvent> = {}): PiEvent {
	return {
		clientId: "c1",
		sessionId: "s1",
		jobId: "j1",
		runId: "j1",
		event: { type: "agent_end", sessionId: "s1" },
		...overrides,
	} as PiEvent;
}

function makeBroker(
	overrides: { runs?: ReturnType<typeof runServiceMock> } = {},
) {
	const requests = new PiRequestBroker();
	requests.bindEmitter(() => {});
	const runs = overrides.runs ?? runServiceMock();
	const broker = new PiEventBroker(requests, runs);
	return { broker, requests, runs };
}

async function collectStream(
	broker: PiEventBroker,
	clientId: string,
	sessionId: string,
	count: number,
): Promise<string[]> {
	const events = await firstValueFrom(
		broker
			.stream(clientId, sessionId)
			.pipe(take(count), toArray(), timeout(2000)),
	);
	return events.map((e) => String(e.data));
}

describe("PiEventBroker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("事件只扇出给同 client/session 订阅者", async () => {
		const { broker } = makeBroker();
		const streamPromise = collectStream(broker, "c1", "s1", 1);

		await broker.publish(
			makeEvent({
				clientId: "c1",
				sessionId: "s1",
				event: { type: "agent_end", sessionId: "s1" },
			}),
		);

		const events = await streamPromise;
		expect(events).toHaveLength(1);
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(events[0] ?? "null");
		} catch {
			// 解析失败视为断言失败
		}
		expect(parsed).toMatchObject({ clientId: "c1", sessionId: "s1" });
	});

	it("其他 session 的订阅者收不到事件", async () => {
		const { broker } = makeBroker();
		const otherPromise = collectStream(broker, "c1", "s2", 1);

		await broker.publish(makeEvent({ sessionId: "s1" }));

		// s2 无事件：心跳 30s 太慢，用短超时验证无数据
		await expect(
			firstValueFrom(broker.stream("c1", "s2").pipe(take(1), timeout(300))),
		).rejects.toThrow();
		await otherPromise.catch(() => {});
	});

	it("interactive request 使用 jobId + runId 进入 waiting", async () => {
		const runs = runServiceMock();
		const { broker } = makeBroker({ runs });

		await broker.publish(
			makeEvent({
				event: {
					type: "extension_request",
					sessionId: "s1",
					ui: { requestId: "u1", extensionId: "e", kind: "confirm" },
				},
			}),
		);
		expect(runs.waitForInput).toHaveBeenCalledWith("j1", "j1");
	});

	it("notify extension_request 不触发 waitForInput", async () => {
		const runs = runServiceMock();
		const { broker } = makeBroker({ runs });

		await broker.publish(
			makeEvent({
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
			}),
		);
		expect(runs.waitForInput).not.toHaveBeenCalled();
		expect(runs.cancelSettlement).not.toHaveBeenCalled();
	});

	it("agent_start 取消 settlement grace", async () => {
		const runs = runServiceMock();
		const { broker } = makeBroker({ runs });

		await broker.publish(
			makeEvent({ event: { type: "agent_start", sessionId: "s1" } }),
		);
		expect(runs.cancelSettlement).toHaveBeenCalledWith("j1", "j1");
	});

	it("prompt_done/agent_settled 触发 settlement 检查", async () => {
		const runs = runServiceMock();
		const { broker } = makeBroker({ runs });

		await broker.publish(
			makeEvent({ event: { type: "prompt_done", sessionId: "s1" } }),
		);
		const scheduleMock = runs.scheduleSettlement as unknown as ReturnType<
			typeof vi.fn
		>;
		expect(scheduleMock).toHaveBeenCalledTimes(1);
		expect(scheduleMock.mock.calls[0]?.slice(0, 2)).toEqual(["j1", "j1"]);

		await broker.publish(
			makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }),
		);
		expect(scheduleMock).toHaveBeenCalledTimes(2);
	});

	function makeSettleBroker(state: Record<string, unknown>) {
		let onSettle: (() => Promise<void>) | null = null;
		const runs = {
			waitForInput: vi.fn(async () => {}),
			resume: vi.fn(async () => {}),
			cancelSettlement: vi.fn(),
			scheduleSettlement: vi.fn(
				async (_jobId: string, _runId: string, cb: () => Promise<void>) => {
					onSettle = cb;
				},
			),
			finishRun: vi.fn(async () => true),
			withReconciledClient: vi.fn(async (_clientId: string, operation: (lease: { clientId: string; socketId: string }) => Promise<unknown>) =>
				operation({ clientId: "c1", socketId: "socket-1" })),
			reconcileState: vi.fn(async () => {}),
		} as unknown as PiRunService;
		const requests = new PiRequestBroker();
		requests.bindEmitter((_socketId, request) => {
			queueMicrotask(() => {
				requests.resolve("socket-1", {
					requestId: request.requestId,
					ok: true,
					data: state,
				});
			});
		});
		const broker = new PiEventBroker(requests, runs);
		return { broker, runs, getOnSettle: () => onSettle };
	}

	it("settlement 只把当前 run 收敛为 idle", async () => {
		const { broker, runs, getOnSettle } = makeSettleBroker({
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			thinkingLevel: "off",
			queuedMessages: { steering: [], followUp: [] },
		});
		await broker.publish(
			makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }),
		);
		expect(getOnSettle()).not.toBeNull();

		await getOnSettle()!();
		expect(runs.scheduleSettlement).toHaveBeenCalledWith(
			"j1",
			"j1",
			expect.any(Function),
		);
		expect(runs.finishRun).toHaveBeenCalledWith("j1", "j1");
	});

	it("settlement 回调在 queue 非空时不 settle", async () => {
		const { broker, runs, getOnSettle } = makeSettleBroker({
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			thinkingLevel: "off",
			queuedMessages: { steering: ["s1"], followUp: [] },
		});
		await broker.publish(
			makeEvent({ event: { type: "prompt_done", sessionId: "s1" } }),
		);

		await getOnSettle()!();
		expect(runs.finishRun).not.toHaveBeenCalled();
	});

	it("settlement 回调在非 idle 状态时不 settle", async () => {
		const { broker, runs, getOnSettle } = makeSettleBroker({
			status: "running",
			streaming: true,
			prompting: true,
			compacting: false,
			thinkingLevel: "off",
			queuedMessages: { steering: [], followUp: [] },
		});
		await broker.publish(
			makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }),
		);

		await getOnSettle()!();
		expect(runs.finishRun).not.toHaveBeenCalled();
	});

	it("仍有排队 Extension 时不恢复 running", async () => {
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
		expect(runs.resume).not.toHaveBeenCalled();
	});

	it("最后一个 Extension 解决后恢复 running", async () => {
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
		expect(runs.resume).toHaveBeenCalledWith("j1", "j1");
	});

	it("prompt_error 只结束当前 run，错误正文仅保留在 SSE", async () => {
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
		expect(runs.cancelSettlement).toHaveBeenCalledWith("j1", "j1");
		expect(runs.finishRun).toHaveBeenCalledWith("j1", "j1");
		expect((await streamPromise)[0]).toContain("SENTINEL_PROMPT_ERROR");
	});
});
