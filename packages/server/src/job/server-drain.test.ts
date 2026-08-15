import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerDrain } from "./server-drain.js";

function mockPrisma() {
	return {
		job: {
			count: vi.fn(),
		},
	};
}

describe("ServerDrain", () => {
	let prisma: ReturnType<typeof mockPrisma>;
	let drain: ServerDrain;

	beforeEach(() => {
		vi.useFakeTimers();
		prisma = mockPrisma();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		drain = new ServerDrain(prisma as any, { pollIntervalMs: 1000 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("drain 开始时置闸门，等运行中 job 收敛到 0 后返回", async () => {
		prisma.job.count
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0);

		const phase = drain.drain(60_000);
		expect(drain.isDraining()).toBe(true);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(phase).resolves.toBeUndefined();

		// running + waiting_input 都算运行中
		expect(prisma.job.count).toHaveBeenCalledWith({
			where: { status: { in: ["running", "waiting_input"] } },
		});
	});

	it("超时仍未收敛时抛错（含剩余数量）", async () => {
		prisma.job.count.mockResolvedValue(3);

		const phase = drain.drain(5000);
		const assertion = expect(phase).rejects.toThrow("仍有 3 个");
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
	});

	it("连续 drain 以先到者为准，闸门保持", async () => {
		prisma.job.count.mockResolvedValue(0);

		await drain.drain(60_000);
		expect(drain.isDraining()).toBe(true);
	});
});
