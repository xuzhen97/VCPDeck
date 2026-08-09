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
		settle: vi.fn(async () => {}),
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

	it("extension_request 触发 waitForInput", async () => {
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
		expect(runs.waitForInput).toHaveBeenCalledWith("j1");
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
		expect(runs.cancelSettlement).toHaveBeenCalledWith("j1");
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
		expect(scheduleMock.mock.calls[0]?.[0]).toBe("j1");

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
				async (_jobId: string, cb: () => Promise<void>) => {
					onSettle = cb;
				},
			),
			settle: vi.fn(async () => {}),
			reconcileState: vi.fn(async () => {}),
		} as unknown as PiRunService;
		const requests = new PiRequestBroker();
		requests.bindEmitter((_clientId, request) => {
			queueMicrotask(() => {
				requests.resolve("c1", {
					requestId: request.requestId,
					ok: true,
					data: state,
				});
			});
		});
		const broker = new PiEventBroker(requests, runs);
		return { broker, runs, getOnSettle: () => onSettle };
	}

	it("settlement 回调只在 idle + queue empty 时 settle", async () => {
		const { broker, runs, getOnSettle } = makeSettleBroker({
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			queuedMessages: { steering: [], followUp: [] },
		});
		await broker.publish(
			makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }),
		);
		expect(getOnSettle()).not.toBeNull();

		await getOnSettle()!();
		expect(runs.settle).toHaveBeenCalledWith(
			"j1",
			expect.objectContaining({ status: "idle" }),
		);
	});

	it("settlement 回调在 queue 非空时不 settle", async () => {
		const { broker, runs, getOnSettle } = makeSettleBroker({
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			queuedMessages: { steering: ["s1"], followUp: [] },
		});
		await broker.publish(
			makeEvent({ event: { type: "prompt_done", sessionId: "s1" } }),
		);

		await getOnSettle()!();
		expect(runs.settle).not.toHaveBeenCalled();
	});

	it("settlement 回调在非 idle 状态时不 settle", async () => {
		const { broker, runs, getOnSettle } = makeSettleBroker({
			status: "running",
			streaming: true,
			prompting: true,
			compacting: false,
			queuedMessages: { steering: [], followUp: [] },
		});
		await broker.publish(
			makeEvent({ event: { type: "agent_settled", sessionId: "s1" } }),
		);

		await getOnSettle()!();
		expect(runs.settle).not.toHaveBeenCalled();
	});

	it("handleState 恢复并返回 accepted run ids", async () => {
		const runs = runServiceMock();
		const { broker } = makeBroker({ runs });

		const accepted = await broker.handleState("c1", {
			clientId: "c1",
			runs: [
				{ jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
				{ jobId: "j2", runId: "j2", sessionId: "s2", status: "done" },
			],
		});
		expect(runs.reconcileState).toHaveBeenCalledWith("c1", expect.any(Object));
		expect(accepted).toEqual(["j2"]);
	});
});
