import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_LOG_LIMITS } from "@vcpdeck/shared";
import { JobLogService } from "./job-log.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";

interface MockJobLogEvent {
	create: ReturnType<typeof vi.fn>;
	count: ReturnType<typeof vi.fn>;
	findMany: ReturnType<typeof vi.fn>;
	deleteMany: ReturnType<typeof vi.fn>;
}

function mockPrisma(): { prisma: PrismaService; jobLogEvent: MockJobLogEvent } {
	const jobLogEvent: MockJobLogEvent = {
		create: vi.fn().mockResolvedValue({ id: 1 }),
		count: vi.fn().mockResolvedValue(0),
		findMany: vi.fn().mockResolvedValue([]),
		deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	return {
		prisma: { jobLogEvent } as unknown as PrismaService,
		jobLogEvent,
	};
}

function captureStdout(): { lines: () => string[]; restore: () => void } {
	const chunks: string[] = [];
	const spy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);
	return {
		lines: () =>
			chunks
				.join("")
				.split("\n")
				.filter((line) => line.trim() !== ""),
		restore: () => spy.mockRestore(),
	};
}

describe("JobLogService", () => {
	let stdout: ReturnType<typeof captureStdout>;

	beforeEach(() => {
		stdout = captureStdout();
	});

	afterEach(() => {
		stdout.restore();
		vi.restoreAllMocks();
	});

	it("record 同时写 stdout 与数据库，字段与契约一致", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		const service = new JobLogService(prisma);

		await service.record({
			jobId: "job-1",
			event: "dispatched",
			source: "server",
			data: { queueWaitMs: 3 },
		});

		expect(jobLogEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				jobId: "job-1",
				source: "server",
				event: "dispatched",
				level: "info",
				code: null,
				message: null,
				data: JSON.stringify({ queueWaitMs: 3 }),
			}),
		});

		const [line] = stdout.lines();
		expect(JSON.parse(line)).toMatchObject({
			level: "info",
			scope: "job",
			jobId: "job-1",
			event: "dispatched",
			source: "server",
			data: { queueWaitMs: 3 },
		});
	});

	it("数据库失败不抛出，只补一条 stdout 警告", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		jobLogEvent.create.mockRejectedValueOnce(new Error("disk full"));
		const service = new JobLogService(prisma);

		await expect(
			service.record({ jobId: "job-2", event: "settled", source: "server" }),
		).resolves.toBeUndefined();

		const warn = stdout
			.lines()
			.map((line) => JSON.parse(line))
			.find((line) => line.scope === "job-log");
		expect(warn).toMatchObject({
			level: "warn",
			jobId: "job-2",
			error: "disk full",
		});
	});

	it("list 按 seq 升序映射 DTO，并返回最后一条 seq 作为游标", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		jobLogEvent.findMany.mockResolvedValue([
			{
				id: 7,
				jobId: "job-3",
				at: new Date("2026-10-17T14:00:00.000Z"),
				source: "client",
				event: "spawned",
				level: "info",
				code: null,
				message: null,
				data: JSON.stringify({ pid: 42, mode: "command" }),
			},
		]);
		const service = new JobLogService(prisma);

		const page = await service.list("job-3", { since: 5, level: "info" });

		expect(jobLogEvent.findMany).toHaveBeenCalledWith({
			where: { jobId: "job-3", id: { gt: 5 }, level: "info" },
			orderBy: { id: "asc" },
			take: JOB_LOG_LIMITS.maxEventsPerJob,
		});
		expect(page.nextSeq).toBe(7);
		expect(page.events[0]).toMatchObject({
			seq: 7,
			source: "client",
			event: "spawned",
			at: "2026-10-17T14:00:00.000Z",
			data: { pid: 42, mode: "command" },
		});
	});

	it("list 空结果回显 since，limit 被限制在 1..上限", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		const service = new JobLogService(prisma);

		const page = await service.list("job-4", { since: 9, limit: 9999 });

		expect(page).toEqual({ jobId: "job-4", events: [], nextSeq: 9 });
		expect(jobLogEvent.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: JOB_LOG_LIMITS.maxEventsPerJob }),
		);
	});

	it("allowClientEvent 按每 Job 上限拒绝", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		jobLogEvent.count.mockResolvedValue(JOB_LOG_LIMITS.maxClientEventsPerJob);
		const service = new JobLogService(prisma);

		await expect(service.allowClientEvent("c1", "job-5")).resolves.toBe(false);
	});

	it("allowClientEvent 按每 Client 每分钟速率拒绝", async () => {
		const { prisma } = mockPrisma();
		const service = new JobLogService(prisma);

		for (let i = 0; i < JOB_LOG_LIMITS.clientEventsPerMinute; i += 1) {
			await expect(service.allowClientEvent("c1", `job-${i}`)).resolves.toBe(
				true,
			);
		}
		await expect(service.allowClientEvent("c1", "job-over")).resolves.toBe(
			false,
		);
		// 不同 Client 各用各的窗口
		await expect(service.allowClientEvent("c2", "job-other")).resolves.toBe(
			true,
		);
	});

	it("pruneExpired 按保留期删除并返回行数", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		jobLogEvent.deleteMany.mockResolvedValue({ count: 5 });
		const service = new JobLogService(prisma);
		const now = new Date("2026-10-17T00:00:00.000Z");

		await expect(service.pruneExpired(now)).resolves.toBe(5);

		const arg = jobLogEvent.deleteMany.mock.calls[0][0] as {
			where: { at: { lt: Date } };
		};
		const expectedCutoff =
			now.getTime() - JOB_LOG_LIMITS.retentionDays * 24 * 60 * 60 * 1000;
		expect(arg.where.at.lt.getTime()).toBe(expectedCutoff);
	});

	it("超出每 Job 上限时优先裁剪最旧的非 error 事件", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		jobLogEvent.count.mockResolvedValue(JOB_LOG_LIMITS.maxEventsPerJob + 2);
		jobLogEvent.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
		const service = new JobLogService(prisma);

		await service.record({ jobId: "job-6", event: "settled", source: "server" });

		expect(jobLogEvent.findMany).toHaveBeenCalledWith({
			where: { jobId: "job-6", level: { not: "error" } },
			orderBy: { id: "asc" },
			take: 2,
			select: { id: true },
		});
		expect(jobLogEvent.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: [1, 2] } },
		});
	});

	it("全部是 error 事件时退化为删除最旧行", async () => {
		const { prisma, jobLogEvent } = mockPrisma();
		jobLogEvent.count.mockResolvedValue(JOB_LOG_LIMITS.maxEventsPerJob + 1);
		jobLogEvent.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: 3 }]);
		const service = new JobLogService(prisma);

		await service.record({ jobId: "job-7", event: "settled", source: "server" });

		expect(jobLogEvent.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: [3] } },
		});
	});
});
