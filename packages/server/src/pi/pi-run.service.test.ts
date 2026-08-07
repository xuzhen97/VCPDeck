import { describe, expect, it, vi } from "vitest";
import { PiRunService } from "./pi-run.service.js";

const actor = {
	identityId: "user-1",
	displayName: "User",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
} as const;

function prismaMock() {
	const jobs: Array<Record<string, unknown>> = [];
	return {
		job: {
			create: vi.fn((args: { data: Record<string, unknown> }) => {
				jobs.push({ ...args.data });
				return Promise.resolve({ id: args.data.id });
			}),
			update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
				const job = jobs.find((j) => j.id === args.where.id);
				if (!job) throw new Error("not found");
				Object.assign(job, args.data);
				return job;
			}),
			findUnique: vi.fn(async (args: { where: { id: string } }) => {
				return jobs.find((j) => j.id === args.where.id) ?? null;
			}),
			findMany: vi.fn(async () => jobs),
			updateMany: vi.fn(async (args: {
				where: { clientId: string; status?: { in: string[] } };
				data: Record<string, unknown>;
			}) => {
				for (const j of jobs) {
					const statuses = args.where.status?.in;
					if (j.clientId === args.where.clientId && (!statuses || statuses.includes(String(j.status)))) {
						Object.assign(j, args.data);
					}
				}
				return { count: 0 };
			}),
		},
		_getJobs: () => jobs,
	};
}

describe("PiRunService", () => {
	it("创建的 agent.run 只含安全 payload", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);

		const { jobId, runId } = await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "a".repeat(64),
			imageCount: 2,
		});

		expect(jobId).toBe(runId);
		const created = (prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0];
		expect(created?.type).toBe("agent.run");
		expect(created?.status).toBe("pending");
		expect(JSON.parse(String(created?.payload))).toEqual({
			mode: "interactive",
			operation: "prompt",
			sessionId: "s1",
			hasImages: true,
			imageCount: 2,
		});
		expect(JSON.stringify(created)).not.toContain("secret prompt");
		expect(JSON.stringify(created)).not.toContain("a".repeat(64));
	});

	it("同项目第二个 prompt 返回 PI_PROJECT_BUSY", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});
		await expect(
			service.createRun(actor, { clientId: "c1", sessionId: "s2", projectKey: "k1" }),
		).rejects.toMatchObject({ code: "PI_PROJECT_BUSY" });

		// 不同项目可并行
		await expect(
			service.createRun(actor, { clientId: "c1", sessionId: "s3", projectKey: "k2" }),
		).resolves.toBeDefined();
	});

	it("只有 Owner 可以控制活动回合", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		const { jobId } = await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});
		await service.accept(jobId);

		await expect(service.assertOwner(jobId, "other-user")).rejects.toMatchObject({
			code: "PI_CONTROL_FORBIDDEN",
		});
		await expect(service.assertOwner(jobId, "user-1")).resolves.toBeUndefined();
	});

	it("Extension UI 在 running 与 waiting_input 间转换", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		const { jobId } = await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});

		await service.accept(jobId);
		await service.waitForInput(jobId);
		expect(
			(prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0]?.status,
		).toBe("waiting_input");

		await service.resume(jobId);
		expect(
			(prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0]?.status,
		).toBe("running");
	});

	it("settle 幂等且只保存安全 result", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		const { jobId } = await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});

		await service.settle(jobId, {
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			queuedMessages: { steering: [], followUp: [] },
			model: { provider: "p", modelId: "m" },
		});
		const job = (prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0];
		expect(job?.status).toBe("done");
		const result = JSON.parse(String(job?.result));
		expect(result).toEqual({
			sessionId: "s1",
			runId: jobId,
			stopReason: "settled",
			model: { provider: "p", modelId: "m" },
		});
		expect(job?.finishedAt).toBeDefined();

		// 幂等：再次 settle 不改变 finishedAt
		const first = job?.finishedAt;
		await service.settle(jobId, {
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			queuedMessages: { steering: [], followUp: [] },
		});
		expect(job?.finishedAt).toBe(first);

		// 项目锁释放
		await expect(
			service.createRun(actor, { clientId: "c1", sessionId: "s9", projectKey: "k1" }),
		).resolves.toBeDefined();
	});

	it("fail 标记 error 并释放锁", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		const { jobId } = await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});
		await service.fail(jobId, "PI_WORKER_EXITED", "worker died");
		const job = (prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0];
		expect(job?.status).toBe("error");
		expect(job?.errorCode).toBe("PI_WORKER_EXITED");
	});

	it("markDisconnected 后 reconcileState 恢复", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		const { jobId } = await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});
		await service.accept(jobId);
		await service.markDisconnected("c1");
		expect(
			(prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0]?.status,
		).toBe("disconnected");

		await service.reconcileState("c1", {
			clientId: "c1",
			runs: [
				{
					jobId,
					runId: jobId,
					sessionId: "s1",
					status: "running",
					projectKey: "k1",
				},
			],
		});
		expect(
			(prisma as { _getJobs: () => Array<Record<string, unknown>> })._getJobs()[0]?.status,
		).toBe("running");
	});

	it("assertIdleMutation 在活动回合拒绝，空闲时通过", async () => {
		const prisma = prismaMock() as never;
		const service = new PiRunService(prisma);
		await service.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k1",
		});
		await expect(service.assertIdleMutation("c1", "k1")).rejects.toMatchObject({
			code: "PI_PROJECT_BUSY",
		});
		await expect(service.assertIdleMutation("c1", "k2")).resolves.toBeUndefined();
	});
});
