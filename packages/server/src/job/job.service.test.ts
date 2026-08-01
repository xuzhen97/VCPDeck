import { describe, it, expect, vi } from "vitest";
import type { JobStatus } from "@vcpdeck/shared";
import { JobService } from "./job.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { JobScheduler } from "./job.scheduler.js";
import type { FileService } from "../file/file.service.js";

function mockPrisma(jobs: Array<Record<string, unknown>>) {
	return {
		job: {
			findMany: vi.fn().mockResolvedValue(jobs),
			count: vi.fn().mockResolvedValue(jobs.length),
			findUnique: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
			create: vi.fn(),
		},
		client: {
			findUnique: vi.fn(),
		},
		frpMapping: {
			findMany: vi.fn(),
			count: vi.fn(),
		},
	} as unknown as PrismaService;
}

function mockScheduler() {
	return {} as unknown as JobScheduler;
}

function mockFileService() {
	return {} as unknown as FileService;
}

function makeService(jobs: Array<Record<string, unknown>>): JobService {
	return new JobService(mockPrisma(jobs), mockScheduler(), mockFileService());
}

describe("JobService.updateProgress()", () => {
	it("写入序列化进度", async () => {
		const prisma = mockPrisma([]);
		const svc = new JobService(prisma, mockScheduler(), mockFileService());

		await svc.updateProgress("job-1", 65536, 158601385);

		expect(prisma.job.update).toHaveBeenCalledWith({
			where: { id: "job-1" },
			data: {
				progress: JSON.stringify({ loaded: 65536, total: 158601385 }),
			},
		});
	});
});

describe("JobService.list() 进度透出", () => {
	it("toJobInfo 解析 progress JSON，无效时返回 null", async () => {
		const svc = makeService([
			{
				id: "j1",
				clientId: "c1",
				client: { hostname: "machine-1" },
				type: "file.export",
				status: "running",
				payload: "{}",
				result: null,
				progress: JSON.stringify({ loaded: 66, total: 158 }),
				errorCode: null,
				errorMessage: null,
				createdAt: new Date(),
				startedAt: null,
				finishedAt: null,
				createdByIdentityId: "i1",
				createdByName: "测试",
				createdVia: "web",
			},
		]);

		const page = await svc.list({ page: 1, pageSize: 20 });
		expect(page.data[0]?.progress).toEqual({ loaded: 66, total: 158 });

		const svcBad = makeService([
			{
				id: "j2",
				clientId: "c1",
				client: { hostname: "machine-1" },
				type: "exec",
				status: "done",
				payload: "{}",
				result: null,
				progress: "not-json",
				errorCode: null,
				errorMessage: null,
				createdAt: new Date(),
				startedAt: null,
				finishedAt: null,
				createdByIdentityId: null,
				createdByName: null,
				createdVia: null,
			},
		]);
		const pageBad = await svcBad.list({ page: 1, pageSize: 20 });
		expect(pageBad.data[0]?.progress).toBeNull();
	});
});

describe("JobService.list()", () => {
	it("returns PaginatedResult with default page/pageSize", async () => {
		const svc = makeService([
			{
				id: "j1",
				clientId: "c1",
				client: { hostname: "machine-1" },
				type: "exec",
				status: "done",
				payload: "{}",
				result: null,
				errorCode: null,
				errorMessage: null,
				createdAt: new Date(),
				startedAt: null,
				finishedAt: null,
				createdByIdentityId: "i1",
				createdByName: "测试",
				createdVia: "web",
			},
		]);

		const result = await svc.list();

		expect(result.data).toHaveLength(1);
		expect(result.total).toBe(1);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(20);
		expect(result.totalPages).toBe(1);
	});

	it("passes skip/take from page and pageSize", async () => {
		const prisma = {
			job: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(50),
				findUnique: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			client: { findUnique: vi.fn() },
			frpMapping: { findMany: vi.fn(), count: vi.fn() },
		} as unknown as PrismaService;

		const svc = new JobService(prisma, mockScheduler(), mockFileService());
		await svc.list({ page: 3, pageSize: 10 });

		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ skip: 20, take: 10 }),
		);
	});

	it("filters by clientId", async () => {
		const prisma = {
			job: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
				findUnique: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			client: { findUnique: vi.fn() },
			frpMapping: { findMany: vi.fn(), count: vi.fn() },
		} as unknown as PrismaService;

		const svc = new JobService(prisma, mockScheduler(), mockFileService());
		await svc.list({ clientId: "c1" });

		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { clientId: "c1" } }),
		);
		expect(prisma.job.count).toHaveBeenCalledWith(
			expect.objectContaining({ where: { clientId: "c1" } }),
		);
	});

	it("filters by status", async () => {
		const prisma = {
			job: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
				findUnique: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			client: { findUnique: vi.fn() },
			frpMapping: { findMany: vi.fn(), count: vi.fn() },
		} as unknown as PrismaService;

		const svc = new JobService(prisma, mockScheduler(), mockFileService());
		await svc.list({ status: "running" as JobStatus });

		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { status: "running" } }),
		);
	});

	it("clamps pageSize to max 100", async () => {
		const prisma = {
			job: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
				findUnique: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			client: { findUnique: vi.fn() },
			frpMapping: { findMany: vi.fn(), count: vi.fn() },
		} as unknown as PrismaService;

		const svc = new JobService(prisma, mockScheduler(), mockFileService());
		await svc.list({ pageSize: 999 });
		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 100 }),
		);

		await svc.list({ pageSize: 0 });
		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 1 }),
		);
	});

	it("computes totalPages correctly", async () => {
		const prisma = {
			job: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(25),
				findUnique: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			client: { findUnique: vi.fn() },
			frpMapping: { findMany: vi.fn(), count: vi.fn() },
		} as unknown as PrismaService;

		const svc = new JobService(prisma, mockScheduler(), mockFileService());
		const result = await svc.list({ pageSize: 10 });
		expect(result.totalPages).toBe(3);
	});

	it("applies multiple filters together", async () => {
		const prisma = {
			job: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
				findUnique: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			client: { findUnique: vi.fn() },
			frpMapping: { findMany: vi.fn(), count: vi.fn() },
		} as unknown as PrismaService;

		const svc = new JobService(prisma, mockScheduler(), mockFileService());
		await svc.list({
			clientId: "c1",
			status: "done" as JobStatus,
			page: 2,
			pageSize: 5,
		});

		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { clientId: "c1", status: "done" },
				skip: 5,
				take: 5,
			}),
		);
	});
});
