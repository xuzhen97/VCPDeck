import { describe, expect, it, vi } from "vitest";
import {
	SHUTDOWN_TIMEOUTS,
	createShutdownRunner,
	shutdownManagedResources,
} from "./shutdown.js";

describe("shutdownManagedResources", () => {
	it("一项释放失败仍等待其它资源收敛", async () => {
		const calls: string[] = [];
		await shutdownManagedResources([
			async () => {
				calls.push("frp");
				throw new Error("fixture");
			},
			async () => {
				await Promise.resolve();
				calls.push("pty");
			},
		]);
		expect(calls.sort()).toEqual(["frp", "pty"]);
	});

	it("挂死的资源在超时后收敛，不阻塞退出", async () => {
		vi.useFakeTimers();
		try {
			const calls: string[] = [];
			const pending = shutdownManagedResources([
				() => new Promise<void>(() => undefined),
				async () => {
					calls.push("pty");
				},
			]);
			await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUTS.resourcesMs);
			await pending;
			expect(calls).toEqual(["pty"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("重复信号只执行一次真实释放", async () => {
		const factory = vi.fn(() => [async () => undefined]);
		const runner = createShutdownRunner(factory);
		await Promise.all([runner(), runner()]);
		await runner();
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("超时阶梯保持 8s < 10s < 15s，避免两层同时动手", () => {
		expect(SHUTDOWN_TIMEOUTS.resourcesMs).toBe(8_000);
		expect(SHUTDOWN_TIMEOUTS.launcherGraceMs).toBe(10_000);
		expect(SHUTDOWN_TIMEOUTS.procdTermMs).toBe(15_000);
		expect(SHUTDOWN_TIMEOUTS.resourcesMs).toBeLessThan(
			SHUTDOWN_TIMEOUTS.launcherGraceMs,
		);
		expect(SHUTDOWN_TIMEOUTS.launcherGraceMs).toBeLessThan(
			SHUTDOWN_TIMEOUTS.procdTermMs,
		);
	});
});
