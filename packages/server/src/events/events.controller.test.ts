import { describe, expect, it, vi } from "vitest";
import { EventsController } from "./events.controller.js";

function makeController() {
	const jobService = {
		createUploadSession: vi.fn(),
		completeUploadSession: vi.fn(),
	} as never;
	const clientService = {} as never;
	const gateway = {
		sendDispatch: vi.fn(),
	} as never;
	const storageService = {
		createExportSession: vi.fn(),
		completeExportUpload: vi.fn(),
		refreshDirectPartUrls: vi.fn(),
		updateUploadProgress: vi.fn(),
	} as never;
	return {
		controller: new EventsController(
			jobService,
			clientService,
			gateway,
			storageService,
		),
		jobService: jobService as {
			createUploadSession: ReturnType<typeof vi.fn>;
			completeUploadSession: ReturnType<typeof vi.fn>;
		},
		gateway: gateway as { sendDispatch: ReturnType<typeof vi.fn> },
		storageService: storageService as {
			createExportSession: ReturnType<typeof vi.fn>;
			completeExportUpload: ReturnType<typeof vi.fn>;
			refreshDirectPartUrls: ReturnType<typeof vi.fn>;
			updateUploadProgress: ReturnType<typeof vi.fn>;
		},
	};
}

describe("EventsController upload sessions", () => {
	it("把创建会话请求交给 JobService", async () => {
		const { controller, jobService } = makeController();
		const body = {
			clientId: "client-1",
			rootDir: "D:\\",
			targetPath: "report.txt",
			filename: "report.txt",
			size: 5,
		};
		const actor = { identityId: "identity-1", source: "web" };
		const expected = {
			jobId: "job-1",
			fileId: "file-1",
			status: "waiting_input",
		};
		jobService.createUploadSession.mockResolvedValue(expected);

		await expect(
			controller.createUploadSession(body, actor as never),
		).resolves.toBe(expected);
		expect(jobService.createUploadSession).toHaveBeenCalledWith(body, actor);
	});

	it("完成会话时转发 dispatch 但只返回结果", async () => {
		const { controller, jobService, gateway } = makeController();
		const result = { jobId: "job-1", status: "running", type: "file.import" };
		const dispatch = {
			jobId: "job-1",
			clientId: "client-1",
			type: "file.import",
			payload: {},
		};
		jobService.completeUploadSession.mockResolvedValue({ result, dispatch });

		await expect(controller.completeUploadSession("job-1", {})).resolves.toBe(
			result,
		);
		expect(gateway.sendDispatch).toHaveBeenCalledWith(dispatch);
	});

	it("没有 dispatch 时不发送 Client 消息", async () => {
		const { controller, jobService, gateway } = makeController();
		const result = { jobId: "job-1", status: "pending", type: "file.import" };
		jobService.completeUploadSession.mockResolvedValue({
			result,
			dispatch: null,
		});

		await controller.completeUploadSession("job-1", {});
		expect(gateway.sendDispatch).not.toHaveBeenCalled();
	});

	describe("导出直传会话端点", () => {
		it("创建导出直传会话", async () => {
			const { controller, storageService } = makeController();
			const session = {
				fileId: "aliyun-file",
				uploadId: "up-1",
				partSize: 64,
				parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
			};
			storageService.createExportSession.mockResolvedValue(session);

			await expect(
				controller.createExportSession({ jobId: "j1", size: 100 }),
			).resolves.toBe(session);
			expect(storageService.createExportSession).toHaveBeenCalledWith(
				"j1",
				100,
			);
		});

		it("完成导出直传并返回 key", async () => {
			const { controller, storageService } = makeController();
			storageService.completeExportUpload.mockResolvedValue({
				key: "aliyun-file",
			});

			await expect(
				controller.completeExportSession("j1", { uploadedBytes: 100 }),
			).resolves.toEqual({ key: "aliyun-file" });
			expect(storageService.completeExportUpload).toHaveBeenCalledWith(
				"j1",
				100,
			);
		});

		it("续期分片 URL", async () => {
			const { controller, storageService } = makeController();
			storageService.refreshDirectPartUrls.mockResolvedValue([
				{ partNumber: 2, url: "https://oss.example/p2-new" },
			]);

			await expect(
				controller.refreshPartUrls("j1", { partNumbers: [2] }),
			).resolves.toEqual([
				{ partNumber: 2, url: "https://oss.example/p2-new" },
			]);
			expect(storageService.refreshDirectPartUrls).toHaveBeenCalledWith(
				"j1",
				[2],
			);
		});

		it("上报直传进度", async () => {
			const { controller, storageService } = makeController();
			storageService.updateUploadProgress.mockResolvedValue(undefined);

			await expect(
				controller.updateProgress("j1", { loaded: 64 }),
			).resolves.toBeUndefined();
			expect(storageService.updateUploadProgress).toHaveBeenCalledWith(
				"j1",
				64,
			);
		});
	});
});
