import { describe, it, expect, vi } from "vitest";
import type { ActorContext, JobStatus } from "@vcpdeck/shared";
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
	const storage = {
		getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
	} as never;
	return new JobService(
		mockPrisma(jobs),
		mockScheduler(),
		mockFileService(),
		storage,
	);
}

describe("JobService upload sessions", () => {
	function makeUploadDeps() {
		const prisma = mockPrisma([]) as any;
		prisma.client.findUnique.mockResolvedValue({
			id: "c1",
			online: true,
			capabilities: ["file.write"],
		});
		const scheduler = {
			tryDispatch: vi.fn(),
		} as any;
		const fileService = {
			createPending: vi.fn().mockResolvedValue({
				fileId: "file-1",
				uploadUrl: "/api/storage/upload/key?expires=1&sig=s",
				expiresAt: 1,
			}),
			findById: vi.fn(),
			createDownloadToken: vi.fn(),
		} as any;
		const storage = {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
			createDirectUploadSession: vi.fn(),
			completeDirectUploadSession: vi.fn(),
		} as any;
		return {
			prisma,
			scheduler,
			fileService,
			storage,
			service: new JobService(prisma, scheduler, fileService, storage),
		};
	}

	const actor: ActorContext = {
		identityId: "identity-1",
		displayName: "测试用户",
		isAdmin: false,
		credentialId: null,
		sessionId: "session-1",
		source: "web",
		requestId: "request-1",
	};

	it("创建 waiting_input 会话且不提前派发", async () => {
		const { prisma, scheduler, fileService, service } = makeUploadDeps();

		const result = await service.createUploadSession(
			{
				clientId: "c1",
				rootDir: "D:\\",
				targetPath: "uploads/a.txt",
				filename: "a.txt",
				size: 5,
				mimeType: "text/plain",
				overwrite: false,
			},
			actor,
		);

		expect(fileService.createPending).toHaveBeenCalledWith(
			expect.any(String),
			"c1",
			expect.objectContaining({
				filename: "a.txt",
				size: 5,
				mimeType: "text/plain",
			}),
		);
		expect(prisma.job.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: "file.import",
				status: "waiting_input",
				payload: JSON.stringify({
					rootDir: "D:\\",
					targetPath: "uploads/a.txt",
					fileId: "file-1",
					overwrite: false,
					storageKind: "local",
				}),
			}),
		});
		expect(scheduler.tryDispatch).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			fileId: "file-1",
			status: "waiting_input",
			upload: { url: "/api/storage/upload/key?expires=1&sig=s" },
		});
	});

	it("未完成 File 时不激活 waiting_input Job", async () => {
		const { prisma, fileService, service } = makeUploadDeps();
		prisma.job.findUnique.mockResolvedValue({
			id: "job-1",
			clientId: "c1",
			type: "file.import",
			status: "waiting_input",
			payload: JSON.stringify({
				rootDir: "D:\\",
				targetPath: "a.txt",
				fileId: "file-1",
			}),
		});
		fileService.findById.mockResolvedValue({ id: "file-1", status: "pending" });

		await expect(service.completeUploadSession("job-1")).rejects.toMatchObject({
			code: "FILE_NOT_READY",
		});
		expect(prisma.job.update).not.toHaveBeenCalled();
	});

	it("完成上传后补全 payload、转 pending 并返回 dispatch", async () => {
		const { prisma, scheduler, fileService, service } = makeUploadDeps();
		prisma.job.findUnique.mockResolvedValue({
			id: "job-1",
			clientId: "c1",
			type: "file.import",
			status: "waiting_input",
			payload: JSON.stringify({
				rootDir: "D:\\",
				targetPath: "a.txt",
				fileId: "file-1",
				overwrite: true,
			}),
		});
		fileService.findById.mockResolvedValue({
			id: "file-1",
			status: "completed",
			key: "storage-key",
			size: 5,
			sha256: "sha",
		});
		fileService.createDownloadToken.mockResolvedValue({
			downloadUrl: "/api/storage/download/storage-key?expires=0&sig=x",
			size: 5,
			sha256: "sha",
		});
		const dispatch = {
			jobId: "job-1",
			clientId: "c1",
			type: "file.import",
			payload: {},
		};
		scheduler.tryDispatch.mockResolvedValue(dispatch);

		const result = await service.completeUploadSession("job-1");

		expect(prisma.job.update).toHaveBeenCalledWith({
			where: { id: "job-1" },
			data: expect.objectContaining({
				status: "pending",
				payload: expect.stringContaining("downloadRef"),
				progress: JSON.stringify({ loaded: 0, total: 5 }),
			}),
		});
		expect(result).toMatchObject({
			result: { jobId: "job-1", status: "running", type: "file.import" },
			dispatch,
		});
	});

	it("重复完成已激活会话时不重复派发", async () => {
		const { prisma, scheduler, service } = makeUploadDeps();
		prisma.job.findUnique.mockResolvedValue({
			id: "job-1",
			clientId: "c1",
			type: "file.import",
			status: "running",
			payload: "{}",
		});

		await expect(service.completeUploadSession("job-1")).resolves.toEqual({
			result: { jobId: "job-1", status: "running", type: "file.import" },
			dispatch: null,
		});
		expect(scheduler.tryDispatch).not.toHaveBeenCalled();
	});
});

describe("JobService.updateProgress()", () => {
	it("写入序列化进度", async () => {
		const prisma = mockPrisma([]);
		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);

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
				timeout: 40_000,
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
		expect(page.data[0]?.timeout).toBe(40_000);

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
				timeout: null,
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

		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);
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

		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);
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

		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);
		await svc.list({ status: "running" as JobStatus });

		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { status: "running" } }),
		);
	});

	it("filters active statuses before pagination", async () => {
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
		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);

		await svc.list({ status: "active" });

		const where = {
			status: { in: ["pending", "running", "waiting_input"] },
			type: {
				notIn: [
					"file.roots",
					"file.list",
					"file.stat",
					"file.readText",
					"frp.list",
				],
			},
		};
		expect(prisma.job.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where }),
		);
		expect(prisma.job.count).toHaveBeenCalledWith({ where });
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

		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);
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

		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);
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

		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);
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

function jobRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "reconcile-1",
		clientId: "c1",
		type: "frp.reconcile",
		status: "done",
		payload: JSON.stringify({
			connectionGeneration: "conn-1",
			expectedRuntimeGeneration: 4,
			attempt: 1,
			timeoutSeconds: 30,
			frpsInfo: { serverAddr: "frps.example.com", serverPort: 7000, authToken: "SUPER_SECRET" },
			mappings: [{ mappingId: "fm_1", name: "tcp-one" }, { mappingId: "fm_2", name: "tcp-two" }],
			preservedMappings: [{ mappingId: "fm_orphan", name: "orphan-9999" }],
		}),
		result: null,
		progress: null,
		timeout: 30,
		errorCode: null,
		errorMessage: null,
		createdAt: new Date("2026-08-30T00:00:00.000Z"),
		startedAt: new Date("2026-08-30T00:00:00.000Z"),
		finishedAt: new Date("2026-08-30T00:00:30.000Z"),
		createdByIdentityId: null,
		createdByName: null,
		createdVia: "system:frp-reconcile",
		client: { hostname: "host", name: "host" },
		...overrides,
	} as Record<string, unknown>;
}

describe("JobService 安全 payload 投影", () => {
	it("frp.reconcile Job 对 REST 隐藏 frpsInfo 和 preserved mapping 正文", async () => {
		const prisma = mockPrisma([jobRow()]) as any;
		prisma.job.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
			jobRow({ id: where.id }),
		);
		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);

		const job = await svc.findById("reconcile-1");

		expect(job?.payload).toEqual({
			attempt: 1,
			mappingCount: 2,
			connectionGeneration: "conn-1",
			expectedRuntimeGeneration: 4,
		});
		expect(JSON.stringify(job)).not.toContain("SUPER_SECRET");
		expect(JSON.stringify(job)).not.toContain("fm_orphan");
	});

	it("frp.create Job 公开 payload 时移除 frpsInfo.authToken", async () => {
		const row = jobRow({
			id: "create-1",
			type: "frp.create",
			payload: JSON.stringify({
				mappingId: "fm_1",
				name: "tcp-1919",
				frpsInfo: { serverAddr: "frps.example.com", serverPort: 7000, authToken: "TOP_SECRET" },
			}),
		});
		const prisma = mockPrisma([row]) as any;
		prisma.job.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
			jobRow({ id: where.id, type: "frp.create" }) as never,
		);
		const svc = new JobService(prisma, mockScheduler(), mockFileService(), {
			getBackendConfig: vi.fn().mockResolvedValue({ kind: "local" }),
		} as never);

		// list 路径同样经过 toJobInfo
		const page = await svc.list({ clientId: "c1", page: 1, pageSize: 20 });
		const info = page.data[0] as { payload: Record<string, unknown> };
		const frpsInfo = info.payload.frpsInfo as Record<string, unknown> | undefined;
		expect(frpsInfo).toEqual({ serverAddr: "frps.example.com", serverPort: 7000 });
		expect(JSON.stringify(page)).not.toContain("TOP_SECRET");
	});
});
