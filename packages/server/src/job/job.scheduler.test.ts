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
				where: {
					clientId: "c1",
					status: "pending",
					type: { notIn: ["agent.run", "agent.session"] },
				},
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
				where: {
					clientId: "c1",
					status: "pending",
					type: { notIn: ["agent.run", "agent.session"] },
				},
			}),
		);
		expect(
			(prisma as { job: { update: ReturnType<typeof vi.fn> } }).job.update,
		).not.toHaveBeenCalled();
	});

	it("Session Job 不计入普通任务并发额度", async () => {
		const prisma = prismaMock() as unknown as {
			job: {
				count: ReturnType<typeof vi.fn>;
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		const scheduler = new JobScheduler(prisma as never);

		await scheduler.tryDispatch("c1");
		expect(prisma.job.count).toHaveBeenCalledWith({
			where: {
				clientId: "c1",
				status: "running",
				type: { notIn: ["agent.run", "agent.session"] },
			},
		});
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
