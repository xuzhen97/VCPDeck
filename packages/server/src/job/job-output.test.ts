import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJobOutputDir, JobService } from "./job.service.js";
import { EventsController } from "../events/events.controller.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { JobScheduler } from "./job.scheduler.js";
import type { FileService } from "../file/file.service.js";
import type { StorageService } from "../storage/storage.service.js";

const tempDirectories: string[] = [];

function makePrisma(job: Record<string, unknown> | null) {
	return {
		job: {
			findUnique: vi.fn().mockResolvedValue(job),
		},
	} as unknown as PrismaService;
}

function makeService(
	job: Record<string, unknown> | null,
	outputDir: string,
): JobService {
	return new JobService(
		makePrisma(job),
		{} as unknown as JobScheduler,
		{} as unknown as FileService,
		{} as unknown as StorageService,
		outputDir,
	);
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("resolveJobOutputDir", () => {
	it("相对路径锚定 appDir，绝对路径原样返回", () => {
		expect(resolveJobOutputDir("/srv/deck")).toBe(
			resolve("/srv/deck", "data/job-outputs"),
		);
		expect(resolveJobOutputDir(undefined)).toBe(
			resolve(process.cwd(), "data/job-outputs"),
		);
	});
});

describe("JobService output spool", () => {
	const job = { id: "job-1", clientId: "client-1", status: "running" };

	it("appendOutputRaw 流式追加同一文件，未知 Job 静默忽略", async () => {
		const root = await mkdtemp(join(tmpdir(), "vcpdeck-job-output-"));
		tempDirectories.push(root);
		const service = makeService(job, root);

		await service.appendOutputRaw("job-1", "step 1 ok\n");
		await service.appendOutputRaw("job-1", "step 2 failed\n");
		await service.appendOutputRaw("missing-job", "不应写入\n");
		await service.appendOutputRaw("job-1", "");

		const content = await readFile(join(root, "job-1.log"), "utf8");
		expect(content).toBe("step 1 ok\nstep 2 failed\n");
	});

	it("readJobOutput 返回全文，无文件或未知 Job 返回 null", async () => {
		const root = await mkdtemp(join(tmpdir(), "vcpdeck-job-output-"));
		tempDirectories.push(root);
		await writeFile(join(root, "job-2.log"), "line-A\nline-B", "utf8");

		const service = makeService({ id: "job-2" }, root);
		await expect(service.readJobOutput("job-2")).resolves.toBe("line-A\nline-B");

		const noFile = makeService({ id: "job-3" }, root);
		await expect(noFile.readJobOutput("job-3")).resolves.toBeNull();

		const unknown = makeService(null, root);
		await expect(unknown.readJobOutput("job-2")).resolves.toBeNull();
	});
});

describe("EventsController GET jobs/:jobId/output", () => {
	function makeController(job: Record<string, unknown> | null) {
		const jobService = {
			findById: vi.fn().mockResolvedValue(job),
			readJobOutput: vi.fn(),
		} as never;
		return {
			controller: new EventsController(
				jobService,
				{ rename: vi.fn() } as never,
				{} as never,
				{} as never,
			),
			jobService: jobService as {
				findById: ReturnType<typeof vi.fn>;
				readJobOutput: ReturnType<typeof vi.fn>;
			},
		};
	}

	it("有输出时返回 jobId 与全文", async () => {
		const { controller, jobService } = makeController({ id: "job-9" });
		jobService.readJobOutput.mockResolvedValue("boom: ENOENT /data/x");

		const result = await controller.getJobOutput("job-9");
		expect(result).toEqual({ jobId: "job-9", output: "boom: ENOENT /data/x" });
		expect(jobService.findById).toHaveBeenCalledWith("job-9");
	});

	it("Job 不存在时抛出 NotFound", async () => {
		const { controller } = makeController(null);
		await expect(controller.getJobOutput("nope")).rejects.toThrow(
			'Job "nope" not found',
		);
	});

	it("无 spool 文件时 output 为 null 而不是报错", async () => {
		const { controller, jobService } = makeController({ id: "job-10" });
		jobService.readJobOutput.mockResolvedValue(null);

		await expect(controller.getJobOutput("job-10")).resolves.toEqual({
			jobId: "job-10",
			output: null,
		});
	});
});
