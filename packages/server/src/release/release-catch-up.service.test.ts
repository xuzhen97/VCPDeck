import { describe, expect, it, vi } from "vitest";
import {
	type CatchUpScheduleHandle,
	ReleaseCatchUpService,
} from "./release-catch-up.service.js";

/** 构造可控的调度依赖，记录注册的回调以便手动触发。 */
function makeSchedule() {
	const registrations: Array<{ delayMs: number; run: () => void }> = [];
	const cancelled: number[] = [];
	const schedule = (
		delayMs: number,
		run: () => void,
	): CatchUpScheduleHandle => {
		const index = registrations.length;
		registrations.push({ delayMs, run });
		return { cancel: () => cancelled.push(index) };
	};
	return { registrations, cancelled, schedule };
}

describe("ReleaseCatchUpService", () => {
	it("按配置间隔注册周期任务，并在销毁时取消", () => {
		const orchestrator = { sweepCatchUp: vi.fn() };
		const { registrations, cancelled, schedule } = makeSchedule();
		const service = new ReleaseCatchUpService(orchestrator as never, {
			sweepIntervalMs: 1234,
			schedule,
			log: () => {},
		});

		service.onModuleInit();
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.delayMs).toBe(1234);

		service.onModuleDestroy();
		expect(cancelled).toEqual([0]);
	});

	it("间隔为 0 时不注册周期任务", () => {
		const orchestrator = { sweepCatchUp: vi.fn() };
		const { registrations, schedule } = makeSchedule();
		const service = new ReleaseCatchUpService(orchestrator as never, {
			sweepIntervalMs: 0,
			schedule,
			log: () => {},
		});

		service.onModuleInit();
		expect(registrations).toHaveLength(0);
	});

	it("周期回调触发一次对账", async () => {
		const orchestrator = { sweepCatchUp: vi.fn().mockResolvedValue(undefined) };
		const { registrations, schedule } = makeSchedule();
		const service = new ReleaseCatchUpService(orchestrator as never, {
			sweepIntervalMs: 10,
			schedule,
			log: () => {},
		});

		service.onModuleInit();
		registrations[0]?.run();
		await vi.waitFor(() => {
			expect(orchestrator.sweepCatchUp).toHaveBeenCalledTimes(1);
		});
	});

	it("对账异常只记录日志，不向上抛出", async () => {
		const orchestrator = {
			sweepCatchUp: vi.fn().mockRejectedValue(new Error("通道未绑定")),
		};
		const logs: string[] = [];
		const service = new ReleaseCatchUpService(orchestrator as never, {
			sweepIntervalMs: 0,
			log: (msg) => logs.push(msg),
		});

		await expect(service.sweep()).resolves.toBeUndefined();
		expect(logs.join("\n")).toContain("通道未绑定");
	});
});
