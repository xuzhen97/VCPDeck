import { describe, expect, it, vi } from "vitest";
import { JobScheduler } from "./job.scheduler.js";

function prismaMock() {
	return {
		job: {
			count: vi.fn().mockResolvedValue(0),
			findFirst: vi.fn().mockResolvedValue(null),
			update: vi.fn().mockResolvedValue({}),
		},
	} as never;
}

describe("JobScheduler", () => {
	it("普通 pending Job 正常调度", async () => {
		const prisma = {
			job: {
				count: vi.fn().mockResolvedValue(0),
				findFirst: vi.fn().mockResolvedValue({
					id: "j1",
					clientId: "c1",
					type: "exec",
					payload: "{}",
					timeout: null,
				}),
				update: vi.fn().mockResolvedValue({}),
			},
		} as never;
		const scheduler = new JobScheduler(prisma);

		const dispatch = await scheduler.tryDispatch("c1");
		expect(dispatch?.type).toBe("exec");
		expect(
			(prisma as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { clientId: "c1", status: "pending", type: { not: "agent.run" } },
			}),
		);
	});

	it("agent.run 不进入普通调度", async () => {
		const prisma = {
			job: {
				count: vi.fn().mockResolvedValue(0),
				// 模拟 DB：只有 agent.run pending，findFirst（排除 agent.run）返回 null
				findFirst: vi.fn().mockResolvedValue(null),
				update: vi.fn().mockResolvedValue({}),
			},
		} as never;
		const scheduler = new JobScheduler(prisma);

		const dispatch = await scheduler.tryDispatch("c1");
		expect(dispatch).toBeNull();
		expect(
			(prisma as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { clientId: "c1", status: "pending", type: { not: "agent.run" } },
			}),
		);
		expect(
			(prisma as { job: { update: ReturnType<typeof vi.fn> } }).job.update,
		).not.toHaveBeenCalled();
	});

	it("并发上限仍生效", async () => {
		const prisma = {
			job: {
				count: vi.fn().mockResolvedValue(3),
				findFirst: vi.fn(),
				update: vi.fn(),
			},
		} as never;
		const scheduler = new JobScheduler(prisma);

		const dispatch = await scheduler.tryDispatch("c1");
		expect(dispatch).toBeNull();
		expect(
			(prisma as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst,
		).not.toHaveBeenCalled();
	});
});

void prismaMock;
